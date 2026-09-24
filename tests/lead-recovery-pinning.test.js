/* ARC-015B — a run, and every action queued against it, is pinned to the configuration
 * snapshot it began under, in production as well as in the test store.
 *
 * ARC-015 built the pin and every test passed, while the production store's run insert
 * left `config_snapshot_id` out. Every real run was unpinned, the claim functions
 * refused all of its work, and Lead Recovery did nothing at all — the canary could not
 * pass and no client could be activated. `MemoryStore` keeps whole objects, and no test
 * looked at what `supabaseStore` actually sent.
 *
 * So this file tests at three levels, each named after the promise it keeps:
 *
 *   1. the production adapter, through a client double that stores only the payload it
 *      is sent (`tests/supabase-double.js`);
 *   2. the contract both stores share, which `MemoryStore` now enforces the way 0013
 *      makes Postgres enforce it;
 *   3. the SQL of 0013 itself, in the textual style the 0010/0011 tests use.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { defaultConfig, validateLeadRecoveryConfig } from '../supabase/functions/_shared/lead-recovery-config.ts';
import { MemoryStore } from '../supabase/functions/_shared/engine/store.ts';
import { supabaseStore } from '../supabase/functions/_shared/supabase-store.ts';
import { FakeClassifier } from '../supabase/functions/_shared/classifier.ts';
import {
  handleInboundMessage,
  intakeLead,
  loadPinnedConfig,
  runDueActions,
} from '../supabase/functions/_shared/engine/runtime.ts';
import { RecordingSender } from '../supabase/functions/_shared/twilio.ts';
import { supabaseDouble } from './supabase-double.js';
import { lifecycleRows, publishedConfigRows, republish, seedPublishedConfig } from './config-fixtures.js';

/* ── fixtures ───────────────────────────────────────────── */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ARC_NUMBER_A = '+16145550100';
const CUSTOMER = '+16145559911';
const SHOP = '+16145550137';
const STAFF = '+16145550188';
const NOW = new Date('2026-09-16T14:00:00.000Z');

function goodConfig(overrides = {}) {
  return validateLeadRecoveryConfig({
    ...defaultConfig(),
    company_name: 'Halstead Heating',
    timezone: 'America/New_York',
    services: ['furnace repair', 'water heater'],
    service_area: { zips: ['43215'], cities: [], note: null },
    forwarding: { destination: SHOP, timeout_seconds: 20 },
    staff_alerts: [{ name: 'Dana', channel: 'sms', address: STAFF }],
    compliance: {
      status: 'approved', brand_registered: true, campaign_ref: 'CMP123',
      reviewed_at: null, opt_out_language: 'Reply STOP to opt out.',
    },
    twilio: {
      subaccount_sid: null, messaging_service_sid: 'MG0123456789abcdef0123456789abcdef',
      phone_number: ARC_NUMBER_A, phone_number_sid: null,
    },
    ...overrides,
  }).config;
}

function configured({ enabled = true } = {}) {
  const store = new MemoryStore();
  seedPublishedConfig(store, { tenantId: TENANT_A, config: goodConfig(), enabled });
  return store;
}

let uuidCounter = 0;
function deps(store, options = {}) {
  let clock = options.now ?? NOW;
  return {
    store,
    liveSender: options.liveSender ?? new RecordingSender(),
    canarySender: options.canarySender === undefined ? new RecordingSender() : options.canarySender,
    now: () => clock,
    advance(ms) { clock = new Date(clock.getTime() + ms); },
    classifierFor: () => options.classifier ?? { classify: async () => ({ ok: false, reason: 'no classifier here' }) },
    urls: { statusCallback: 'https://example.test/functions/v1/twilio/message-status' },
    uuid: () => {
      uuidCounter += 1;
      return `cccccccc-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`;
    },
    worker: 'test',
  };
}

const missedCall = (overrides = {}) => ({
  tenantId: TENANT_A,
  source: 'missed_call',
  externalRef: `CA${String(++uuidCounter).padStart(32, '0')}`,
  phone: CUSTOMER,
  customerName: 'Dana Reyes',
  intakeRef: ARC_NUMBER_A,
  consentSms: true,
  consentSource: 'inbound_call',
  ...overrides,
});

const runRow = (overrides = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  tenantId: TENANT_A,
  leadId: 'aaaaaaaa-0000-4000-8000-000000000002',
  moduleKey: 'lead_recovery',
  state: 'new',
  configVersion: 3,
  configSnapshotId: null,
  /* a synthetic run, so the lifecycle's own rules (0015) stay out of the way of the pin's. */
  runMode: 'test',
  stoppedAt: null,
  completedAt: null,
  stopReason: null,
  lastError: null,
  ...overrides,
});

/**
 * A store whose tenant A has the synthetic lead `runRow()` names and a module under test —
 * the lifecycle permits a test run, so every refusal below is the pin's alone.
 */
function contractStore() {
  const store = new MemoryStore();
  store.leads.push({
    id: 'aaaaaaaa-0000-4000-8000-000000000002', tenantId: TENANT_A, correlationId: 'aaaaaaaa-0000-4000-8000-0000000000c0',
    source: 'web_form', intakeRef: null, customerName: null, phone: null, email: null, serviceRequest: null,
    locationZip: null, locationText: null, urgency: null, safetyFlags: [], aiSummary: null, status: 'new',
    consentSms: false, consentSource: null, consentAt: null, assignedTo: null, bookingOutcome: null, bookedAt: null,
    isCanary: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  store.lifecycles.push({
    id: 'aaaaaaaa-0000-4000-8000-0000000000c1', tenantId: TENANT_A, moduleKey: 'lead_recovery', state: 'testing',
    stateVersion: 2, pendingRequirements: [], observed: null, authorized: null, tested: null, testEvidenceId: null,
    shadowed: null, shadowEvidenceId: null, healthStatus: 'unverified', healthReason: null, healthEvidence: {},
    healthCheckedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  return store;
}

async function snapshotIn(store, tenantId = TENANT_A, overrides = {}) {
  return store.createConfigSnapshot({
    tenantId,
    moduleKey: 'lead_recovery',
    configVersion: 3,
    schemaVersion: 1,
    config: goodConfig(),
    configHash: (tenantId === TENANT_A ? 'a' : 'b').repeat(64),
    ...overrides,
  });
}

/** Postgres with this tenant's configuration in it, seen through the production adapter. */
function productionStore({ enabled = true } = {}) {
  const versions = publishedConfigRows(TENANT_A, goodConfig());
  const db = supabaseDouble({
    /* the switch row, and the published versions 0014 resolves configuration from. */
    module_configs: [{
      tenant_id: TENANT_A, module_key: 'lead_recovery', enabled,
      schema_version: 1, config_version: 1, config: {},
    }],
    ...versions,
    /* 0015: the lifecycle an operator left — live on these versions, or under test. */
    ...lifecycleRows(TENANT_A, versions, { state: enabled ? 'active' : 'testing' }),
    tenants: [{ id: TENANT_A, status: 'active' }],
  });
  return { db, store: supabaseStore(db) };
}

/* ══ 1. the production adapter ════════════════════════════ */

describe('the production store persists the pin the engine hands it', () => {
  test('the run insert carries config_snapshot_id', async () => {
    const db = supabaseDouble();
    await supabaseStore(db).createRun(runRow({ configSnapshotId: 'aaaaaaaa-0000-4000-8000-00000000000f' }));

    const insert = db.writes.find((w) => w.table === 'automation_runs' && w.op === 'insert');
    assert.equal(insert.payload[0].config_snapshot_id, 'aaaaaaaa-0000-4000-8000-00000000000f',
      'the column the defect dropped is in the payload');
  });

  test('a run read back from Postgres is the run the engine created, field for field', async () => {
    /* the contract both stores must keep. before ARC-015B the production store handed
       back configSnapshotId: null for a run created with one. */
    const memory = contractStore();
    const snapshot = await snapshotIn(memory);
    const input = runRow({ configSnapshotId: snapshot.id });

    const fromMemory = await memory.createRun(input);
    const fromPostgres = await supabaseStore(supabaseDouble()).createRun(input);

    for (const key of Object.keys(input)) {
      assert.deepEqual(fromPostgres[key], input[key], `production store dropped or changed ${key}`);
      assert.deepEqual(fromMemory[key], input[key], `memory store dropped or changed ${key}`);
    }
  });

  test('the action insert carries the pin, and reads it back', async () => {
    const db = supabaseDouble();
    const store = supabaseStore(db);
    const { action } = await store.scheduleAction({
      tenantId: TENANT_A,
      runId: 'aaaaaaaa-0000-4000-8000-000000000001',
      actionType: 'send_followup',
      runAt: NOW.toISOString(),
      idempotencyKey: 'run:send_followup',
      configSnapshotId: 'aaaaaaaa-0000-4000-8000-00000000000f',
      payload: {},
    });

    const insert = db.writes.find((w) => w.table === 'scheduled_actions');
    assert.equal(insert.payload[0].config_snapshot_id, 'aaaaaaaa-0000-4000-8000-00000000000f');
    assert.equal(action.configSnapshotId, 'aaaaaaaa-0000-4000-8000-00000000000f');
  });

  test('an action queued without a pin leaves the column for the database to derive', async () => {
    const db = supabaseDouble();
    await supabaseStore(db).scheduleAction({
      tenantId: TENANT_A,
      runId: 'aaaaaaaa-0000-4000-8000-000000000001',
      actionType: 'close_run',
      runAt: NOW.toISOString(),
      idempotencyKey: 'run:close_run',
      payload: {},
    });
    const insert = db.writes.find((w) => w.table === 'scheduled_actions');
    assert.ok('config_snapshot_id' in insert.payload[0], 'the column is always named');
    assert.equal(insert.payload[0].config_snapshot_id, null, 'and a missing pin is never invented here');
  });

  test('a missed call through the production store pins the run and its first action to one snapshot', async () => {
    const { db, store } = productionStore();
    const result = await intakeLead(deps(store), missedCall());
    assert.equal(result.ok, true);

    const [snapshot] = db.table('lead_recovery_config_snapshots');
    const [run] = db.table('automation_runs');
    const actions = db.table('scheduled_actions');

    assert.ok(snapshot, 'a snapshot was written');
    assert.equal(run.config_snapshot_id, snapshot.id, 'the run row in Postgres points at it');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].config_snapshot_id, snapshot.id, 'and so does the action queued against it');
  });

  test('the canary through the production store queues work pinned to its own snapshot', async () => {
    const { db, store } = productionStore({ enabled: false });
    const result = await intakeLead(deps(store), missedCall({ externalRef: 'canary:prod', isCanary: true }));
    assert.equal(result.ok, true, 'a canary is exempt from the switch');

    const [run] = db.table('automation_runs');
    assert.ok(run.config_snapshot_id, 'the synthetic run is pinned like a real one');
    for (const action of db.table('scheduled_actions')) {
      assert.equal(action.config_snapshot_id, run.config_snapshot_id);
    }
  });

  test('the operator retry path never re-queues an unpinned action', async () => {
    const legacy = { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', tenant_id: TENANT_A, status: 'failed', config_snapshot_id: null, action_type: 'send_followup' };
    const pinned = { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', tenant_id: TENANT_A, status: 'failed', config_snapshot_id: 'aaaaaaaa-0000-4000-8000-00000000000f', action_type: 'send_followup' };
    const db = supabaseDouble({ scheduled_actions: [legacy, pinned] });
    const store = supabaseStore(db);

    assert.equal(await store.retryAction(TENANT_A, legacy.id, NOW.toISOString()), null,
      'a legacy action stays failed rather than sitting on the queue unclaimable');
    const retried = await store.retryAction(TENANT_A, pinned.id, NOW.toISOString());
    assert.equal(retried.status, 'pending');
    assert.equal(retried.configSnapshotId, pinned.config_snapshot_id);
  });
});

/* ══ 2. the contract both stores keep ═════════════════════ */

describe('a run is born pinned, to a snapshot it is entitled to', () => {
  test('a new run with no snapshot is refused', async () => {
    const store = contractStore();
    await assert.rejects(store.createRun(runRow()), /must be pinned to a configuration snapshot/);
    assert.equal(store.runs.length, 0);
  });

  test("a run on another tenant's snapshot is refused", async () => {
    const store = contractStore();
    const theirs = await snapshotIn(store, TENANT_B);
    await assert.rejects(store.createRun(runRow({ configSnapshotId: theirs.id })), /does not belong to tenant/);
  });

  test("a run on another module's snapshot is refused", async () => {
    const store = contractStore();
    const other = await snapshotIn(store, TENANT_A, { moduleKey: 'estimate_recovery' });
    await assert.rejects(store.createRun(runRow({ configSnapshotId: other.id })), /snapshot is for module estimate_recovery/);
  });

  test('a run on a schema version the registry does not list is refused', async () => {
    const store = contractStore();
    const odd = await snapshotIn(store, TENANT_A, { schemaVersion: 7 });
    await assert.rejects(
      store.createRun(runRow({ configSnapshotId: odd.id })),
      /schema version 7 is not a registered configuration schema for lead_recovery/,
    );
  });

  test('a tenant-owned, registered snapshot creates a pinned run', async () => {
    const store = contractStore();
    const snapshot = await snapshotIn(store);
    const run = await store.createRun(runRow({ configSnapshotId: snapshot.id }));
    assert.equal(run.configSnapshotId, snapshot.id);
  });

  test("a run's pin cannot be changed or cleared", async () => {
    const store = contractStore();
    const first = await snapshotIn(store);
    const second = await snapshotIn(store, TENANT_A, { configHash: 'c'.repeat(64) });
    const run = await store.createRun(runRow({ configSnapshotId: first.id }));

    await assert.rejects(store.updateRun(TENANT_A, run.id, { configSnapshotId: second.id }), /fixed when the run is created/);
    await assert.rejects(store.updateRun(TENANT_A, run.id, { configSnapshotId: null }), /fixed when the run is created/);
    assert.equal(store.runs[0].configSnapshotId, first.id);

    /* the state machine still moves. */
    await store.updateRun(TENANT_A, run.id, { state: 'response_queued' });
    assert.equal(store.runs[0].state, 'response_queued');
  });
});

describe("an action carries exactly its run's pin", () => {
  async function pinnedRun() {
    const store = contractStore();
    const snapshot = await snapshotIn(store);
    const run = await store.createRun(runRow({ configSnapshotId: snapshot.id }));
    return { store, snapshot, run };
  }
  const action = (run, overrides = {}) => ({
    tenantId: run.tenantId, runId: run.id, actionType: 'send_followup',
    runAt: NOW.toISOString(), idempotencyKey: `k-${Math.random()}`, payload: {}, ...overrides,
  });

  test("an action queued without a pin inherits the run's", async () => {
    const { store, run } = await pinnedRun();
    const { action: queued } = await store.scheduleAction(action(run));
    assert.equal(queued.configSnapshotId, run.configSnapshotId);
  });

  test("an action whose pin differs from its run's is refused", async () => {
    const { store, run } = await pinnedRun();
    const other = await snapshotIn(store, TENANT_A, { configHash: 'd'.repeat(64) });
    await assert.rejects(store.scheduleAction(action(run, { configSnapshotId: other.id })), /is not the snapshot of run/);
    assert.equal(store.actions.length, 0);
  });

  test("an action cannot be queued on another tenant's run", async () => {
    const { store, run } = await pinnedRun();
    await assert.rejects(store.scheduleAction(action(run, { tenantId: TENANT_B })), /does not belong to tenant/);
  });

  test('nothing can be queued against a legacy run with no pin', async () => {
    const { store, run } = await pinnedRun();
    store.runs[0].configSnapshotId = null;   // what every pre-0011 run looks like
    await assert.rejects(store.scheduleAction(action(run)), /has no configuration snapshot/);
  });

  test('an unpinned or mismatched action is never claimable, and a matched one is', async () => {
    const { store, run } = await pinnedRun();
    await store.scheduleAction(action(run, { runAt: NOW.toISOString(), idempotencyKey: 'good' }));
    await store.scheduleAction(action(run, { runAt: NOW.toISOString(), idempotencyKey: 'no-pin' }));
    await store.scheduleAction(action(run, { runAt: NOW.toISOString(), idempotencyKey: 'wrong-pin' }));
    store.actions.find((a) => a.idempotencyKey === 'no-pin').configSnapshotId = null;
    store.actions.find((a) => a.idempotencyKey === 'wrong-pin').configSnapshotId = 'aaaaaaaa-0000-4000-8000-0000000000ff';

    const claimed = await store.claimActions({ limit: 10, worker: 'w', nowIso: NOW.toISOString(), tenantId: null });
    assert.deepEqual(claimed.map((a) => a.idempotencyKey), ['good']);
  });

  test('a legacy unpinned action can be cancelled but is never put back on the queue', async () => {
    const { store, run } = await pinnedRun();
    await store.scheduleAction(action(run, { idempotencyKey: 'legacy' }));
    const legacy = store.actions[0];
    legacy.configSnapshotId = null;
    legacy.status = 'failed';

    assert.equal(await store.retryAction(TENANT_A, legacy.id, NOW.toISOString()), null);
    assert.equal(legacy.status, 'failed');

    legacy.status = 'pending';
    assert.equal(await store.cancelPendingActions(TENANT_A, run.id, 'reviewed by an operator'), 1);
    assert.equal(legacy.status, 'cancelled');
  });
});

/* ══ 3. the engine pins everything it queues ══════════════ */

describe('every action the engine queues is pinned to its run', () => {
  const assertAllPinned = (store) => {
    assert.ok(store.actions.length > 0);
    for (const action of store.actions) {
      const run = store.runs.find((r) => r.id === action.runId);
      assert.ok(action.configSnapshotId, `${action.actionType} has no pin`);
      assert.equal(action.configSnapshotId, run.configSnapshotId, `${action.actionType} is not pinned to its run`);
    }
  };

  test('first response, follow-up, close, classification and routing all carry the run’s pin', async () => {
    const store = configured();
    const d = deps(store, {
      classifier: new FakeClassifier({ confidence: 0.95, service_type: 'furnace repair', zip: '43215' }),
    });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });                       // first response → follow-up + close
    await handleInboundMessage(d, {
      tenantId: TENANT_A, from: CUSTOMER, to: ARC_NUMBER_A,
      body: 'furnace repair please, 43215', providerMessageId: 'SMreply1', occurredAt: NOW,
    });                                                               // → classify_reply
    await runDueActions(d, { tenantId: null });                       // → route_to_contractor
    await runDueActions(d, { tenantId: null });

    const types = new Set(store.actions.map((a) => a.actionType));
    for (const type of ['send_first_response', 'send_followup', 'close_run', 'classify_reply', 'route_to_contractor']) {
      assert.ok(types.has(type), `the flow queued ${type}`);
    }
    assertAllPinned(store);
  });

  test('a safety handoff queued at intake carries the run’s pin', async () => {
    const store = configured();
    const d = deps(store);
    await intakeLead(d, missedCall({ serviceRequest: 'I smell gas in the basement' }));
    assert.equal(store.actions[0].actionType, 'open_handoff');
    await runDueActions(d, { tenantId: null });
    assertAllPinned(store);
  });

  test('a retried action keeps its pin across the retry', async () => {
    const store = configured();
    const flaky = new RecordingSender({
      ok: false, sid: null, errorCode: '20429', errorMessage: 'too many requests', permanent: false, ambiguous: false,
    });
    const d = deps(store, { liveSender: flaky });
    await intakeLead(d, missedCall());
    const pin = store.actions[0].configSnapshotId;

    const summary = await runDueActions(d, { tenantId: null });
    assert.equal(summary.retried, 1);
    assert.equal(store.actions[0].status, 'pending');
    assert.equal(store.actions[0].configSnapshotId, pin);
  });

  test('a follow-up fires under the snapshot it was queued with, whatever the configuration says now', async () => {
    const store = configured();
    const sender = new RecordingSender();
    const d = deps(store, { liveSender: sender });
    await intakeLead(d, missedCall());
    await runDueActions(d, { tenantId: null });

    const followup = store.actions.find((a) => a.actionType === 'send_followup');
    const pin = followup.configSnapshotId;

    /* the operator renames the company while the follow-up is waiting — a new version. */
    await republish(store, TENANT_A, { company_name: 'Somebody Else Entirely' });

    followup.runAt = NOW.toISOString();
    await runDueActions(d, { tenantId: null });

    assert.equal(followup.configSnapshotId, pin, 'the pin did not move');
    const sent = sender.sent.at(-1).body;
    assert.match(sent, /Halstead Heating/, 'the words come from the pinned snapshot');
    assert.doesNotMatch(sent, /Somebody Else/);

    /* and the next lead is the one that gets the new rules. */
    await intakeLead(d, missedCall({ phone: '+16145559933' }));
    const next = store.runs.at(-1);
    assert.notEqual(next.configSnapshotId, pin);
    assert.equal((await loadPinnedConfig(store, next)).config.company_name, 'Somebody Else Entirely');
  });

  test('a tenant with no valid configuration records the lead and starts no run', async () => {
    const store = new MemoryStore();
    const result = await intakeLead(deps(store), missedCall());

    assert.equal(result.ok, false);
    assert.equal(result.run, null);
    assert.equal(store.leads.length, 1, 'somebody still tried to reach this business');
    assert.equal(store.runs.length, 0, 'a run that could not be pinned is not created');
    assert.equal(store.actions.length, 0);

    const [ended] = store.eventsOfType('automation_completed', TENANT_A);
    assert.equal(ended.event.payload.stop_reason, 'not_permitted');
    assert.equal(ended.event.payload.started, false);
    assert.equal(store.invalidEvents.length, 0);
  });

  test('the synthetic canary is pinned end to end and never touches the live sender', async () => {
    const store = configured({ enabled: false });
    const live = new RecordingSender();
    const canary = new RecordingSender();
    const d = deps(store, { liveSender: live, canarySender: canary });

    await intakeLead(d, missedCall({ externalRef: 'canary:pinning', isCanary: true }));
    const summary = await runDueActions(d, { tenantId: TENANT_A, canaryOnly: true, worker: 'ops-canary' });

    assert.equal(summary.claimed, 1);
    assert.equal(store.runs[0].state, 'awaiting_reply', 'the state the ops canary checks for');
    assertAllPinned(store);
    assert.equal(live.sent.length, 0);
    assert.equal(canary.sent.length, 1);
    for (const e of store.eventsOfType('sms_sent', TENANT_A)) assert.equal(e.event.is_canary, true);
  });
});

/* ══ 4. the migration ═════════════════════════════════════ */

describe('0013 makes the pin the database’s rule', () => {
  const sql = readFileSync(
    new URL('../supabase/migrations/0013_lead_recovery_snapshot_pinning.sql', import.meta.url),
    'utf8',
  );
  const body = (name) => {
    const start = sql.indexOf(`function public.${name}`);
    return sql.slice(start, sql.indexOf('$fn$;', start));
  };

  test('a new run without a snapshot is refused', () => {
    assert.match(body('automation_runs_guard_snapshot'), /new\.config_snapshot_id is null[\s\S]*must be pinned/);
  });

  test("a run's snapshot must be its own tenant's, for its own module, at a registered schema", () => {
    const fn = body('automation_runs_guard_snapshot');
    assert.match(fn, /s\.tenant_id = new\.tenant_id/);
    assert.match(fn, /v_module <> new\.module_key/);
    assert.match(fn, /from public\.registry_module_versions mv/, 'the registry is the vocabulary');
    assert.match(fn, /mv\.config_schema_version = v_schema/);
  });

  test("an action's pin is derived from its run, and a mismatch is refused", () => {
    const fn = body('scheduled_actions_guard_snapshot');
    assert.match(fn, /new\.config_snapshot_id := v_run_snapshot/);
    assert.match(fn, /new\.config_snapshot_id <> v_run_snapshot/);
    assert.match(fn, /has no configuration snapshot/);
  });

  test('neither pin can move once set', () => {
    assert.match(body('automation_runs_guard_snapshot'), /new\.config_snapshot_id is distinct from old\.config_snapshot_id/);
    assert.match(body('scheduled_actions_guard_snapshot'), /new\.config_snapshot_id is distinct from old\.config_snapshot_id/);
    assert.match(sql, /before insert or update on public\.automation_runs/);
    assert.match(sql, /before insert or update on public\.scheduled_actions/);
  });

  test("an action's pin is structurally its run's", () => {
    assert.match(sql, /unique \(id, tenant_id, config_snapshot_id\)/);
    assert.match(sql, /foreign key \(run_id, tenant_id, config_snapshot_id\)\s+references public\.automation_runs \(id, tenant_id, config_snapshot_id\)/);
  });

  test('a claim needs both pins, and equal', () => {
    const fn = body('claim_actions_internal');
    assert.match(fn, /r\.config_snapshot_id is not null/);
    assert.match(fn, /a\.config_snapshot_id is not null/);
    assert.match(fn, /a\.config_snapshot_id = r\.config_snapshot_id/);
    assert.match(fn, /a\.attempts < a\.max_attempts/, 'the 0011 attempt cap survives the redefinition');
    assert.match(fn, /l\.is_canary/, 'and so does canary-only claiming');
  });

  test('legacy rows are blocked, never guessed at', () => {
    assert.match(sql, /set status = 'blocked'/);
    assert.ok(!/from public\.module_configs|join public\.module_configs/.test(sql),
      'nothing reconstructs a historical pin from the current configuration');
    const backfill = sql.slice(sql.indexOf('update public.scheduled_actions a\n   set config_snapshot_id'));
    assert.match(backfill.slice(0, 400), /set config_snapshot_id = r\.config_snapshot_id/, 'the only pin written is the run’s own');
  });

  test('a legacy action cannot be put back on the queue', () => {
    assert.match(body('scheduled_actions_guard_snapshot'), /new\.config_snapshot_id is null\s+and new\.status in \('pending', 'claimed'\)/);
  });

  test('no browser role can run the claim or the guards', () => {
    for (const fn of ['claim_actions_internal', 'automation_runs_guard_snapshot', 'scheduled_actions_guard_snapshot']) {
      assert.match(sql, new RegExp(`revoke all on function public\\.${fn}[^;]*from public, anon, authenticated`));
    }
  });

  test('nothing is widened: no policy is added and no module_key constraint is dropped', () => {
    assert.ok(!/create policy/i.test(sql));
    assert.ok(!/drop constraint[\s\S]{0,80}module_key/.test(sql));
    assert.ok(!/security definer/.test(body('automation_runs_guard_snapshot')), 'the guards run with the writer’s rights');
    assert.ok(!/security definer/.test(body('scheduled_actions_guard_snapshot')));
  });
});
